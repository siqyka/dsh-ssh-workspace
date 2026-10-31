/**
 * Smoke-test runner for dsh-ssh-workspace.
 *
 * Runs every `*-smoke.mjs` suite in this directory, in a fixed order, each as
 * its own child process so a crashed suite cannot take the others down.
 * Suites that need a live SSH host or the assembled DSH tree skip themselves
 * (exit 0 with a SKIP note) when their environment variables are unset, so a
 * bare checkout always runs the pure suites.
 *
 * Three suites need the host's own framework rather than a stand-in — Cordis
 * service ordering (lifecycle), profile boot (boot), and the enforced schema
 * subset (tool-schemas). Those still skip unless DSH_CORE_ROOT names a REAL
 * assembled tree; a stub cannot verify what they exist to verify, and a false
 * pass would be worse than an honest skip.
 *
 * ## Three outcomes, not two
 *
 * A skipping suite exits 0, which is indistinguishable from a passing one at the
 * process level. That is how a summary could read "all green" while several
 * suites had never executed. The runner therefore classifies each suite as
 * pass / skip / fail and prints the skipped ones by name, so a reader can see
 * exactly which evidence is missing.
 *
 * Usage:
 *   node tests/run.mjs                 # everything (live suites skip if not configured)
 *   node tests/run.mjs live acceptance # only the named suites
 *
 * Environment (all optional):
 *   DSH_CORE_ROOT     node_modules dir holding @deepseek-ai/* and ssh2
 *                     (e.g. an assembled copy of the installed app's tree).
 *                     When unset, a minimal stub root is generated under
 *                     tests/.peer-stubs so the peer-dependent suites RUN instead
 *                     of skipping — a skipped suite cannot fail, and one such
 *                     skip is how a broken route shipped green.
 *   DSH_NO_PEER_STUBS set to 1 to never generate the stub root
 *   DSH_WS_TEST_ALIAS an alias from the host store / ~/.ssh/config to test against
 *   DSH_WS_TEST_DIR   remote scratch parent dir (default /tmp/dsh-ssh-workspace-test)
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { installPeerStubs } from './peer-stubs.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))

/** Suite order: pure checks first, live-host suites last. */
const SUITES = [
  'protocol',
  'peers',
  'peer-mode',
  'diagnostics',
  'reconnect',
  'fake-transport',
  'replay',
  'host-key',
  'host-listing',
  'scratch-safety',
  'doc-numbers',
  'upstream-contract',
  'client-shape',
  'backdrop-dismiss',
  'projection-relax',
  'projection-real',
  'tree-transfer',
  'insert-once',
  'locale-register',
  'detach',
  'probe',
  'lifecycle',
  'phase6',
  'watch-lifecycle',
  'store-lock',
  'transfer',
  'mode-gate',
  'shell',
  'terminal',
  'transport',
  'forward',
  'forward-persist',
  'capabilities',
  'routes',
  'boot',
  'secrets',
  'tool-schemas',
  'live',
  'acceptance',
]

const requested = process.argv.slice(2)
const names = requested.length > 0 ? SUITES.filter(name => requested.includes(name)) : SUITES
if (names.length === 0) {
  console.error(`no suite matches ${JSON.stringify(requested)}; known: ${SUITES.join(', ')}`)
  process.exit(2)
}

// A checkout without an assembled DSH tree used to skip every suite that imports
// routes.js or remote-fs.js. Skipping is not passing: this run generates a
// minimal stub root unless the caller supplied a real one (or opted out), so the
// plugin's own logic is exercised on a bare checkout too. Suites that need a LIVE
// host still skip on DSH_WS_TEST_ALIAS — a stub cannot fake an SSH server.
const childEnv = { ...process.env }
if (!childEnv.DSH_CORE_ROOT && childEnv.DSH_NO_PEER_STUBS !== '1') {
  try {
    childEnv.DSH_CORE_ROOT = installPeerStubs(path.join(here, '.peer-stubs'))
    console.log(`\n[peer stubs: ${childEnv.DSH_CORE_ROOT}]`)
  } catch (error) {
    console.log(`\n[warn: could not build the peer stub root: ${error instanceof Error ? error.message : String(error)}]`)
  }
}

/**
 * Per-suite outcomes, in three states.
 *
 * A suite that skips exits 0, exactly like one that passes, so "everything
 * green" used to be able to mean "several suites never ran". The exit code is
 * the only channel a child process has, so the runner detects a skip the way the
 * suites themselves announce it: by looking for the skip line they print. That
 * keeps every suite unchanged — it still prints the line for a human — while
 * letting the summary tell PASS from SKIP.
 *
 * @type {Array<{name: string, state: 'pass'|'skip'|'fail', detail?: string}>}
 */
const outcomes = []
for (const name of names) {
  const file = path.join(here, `${name}-smoke.mjs`)
  console.log(`\n──────────────────────────  ${name}-smoke  ──────────────────────────`)
  if (!existsSync(file)) {
    console.log(`  FAIL  suite file is missing: ${file}`)
    outcomes.push({ name, state: 'fail', detail: 'suite file is missing' })
    continue
  }
  // Output is captured AND forwarded: the user still watches the suite run live,
  // and the runner keeps the text it needs to classify the outcome.
  const result = spawnSync(process.execPath, [file], { encoding: 'utf8', env: childEnv })
  if (result.stdout !== null && result.stdout !== undefined && result.stdout !== '') process.stdout.write(result.stdout)
  if (result.stderr !== null && result.stderr !== undefined && result.stderr !== '') process.stderr.write(result.stderr)
  if (result.error !== undefined && result.error !== null) {
    console.log(`  FAIL  could not spawn the suite: ${result.error.message}`)
    outcomes.push({ name, state: 'fail', detail: result.error.message })
    continue
  }
  if (result.status !== 0) {
    outcomes.push({ name, state: 'fail', detail: `exit ${result.status}` })
    continue
  }
  // A skip LINE, not the word "skip" anywhere: a suite's prose may mention it.
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const skipped = /^\s*SKIP\s/mu.test(output)
  outcomes.push({ name, state: skipped ? 'skip' : 'pass' })
}

const failed = outcomes.filter(outcome => outcome.state === 'fail')
const skipped = outcomes.filter(outcome => outcome.state === 'skip')
const passed = outcomes.filter(outcome => outcome.state === 'pass')

console.log(`\n=== run.mjs: ${passed.length} passed, ${skipped.length} skipped, ${failed.length} failed (${names.length} suite(s)) ===`)
// Skips are listed by name and never folded into the pass count: a reader must
// be able to see which evidence is missing, not just that nothing failed.
if (skipped.length > 0) {
  console.log('skipped (did NOT run — set the environment each suite names to include them):')
  for (const outcome of skipped) console.log(`  SKIP  ${outcome.name}-smoke`)
}
if (failed.length > 0) {
  console.log('failed:')
  for (const outcome of failed) console.log(`  FAIL  ${outcome.name}-smoke${outcome.detail === undefined ? '' : ` — ${outcome.detail}`}`)
}
process.exit(failed.length === 0 ? 0 : 1)
