/**
 * Smoke-test runner for dsh-ssh-workspace.
 *
 * Runs every `*-smoke.mjs` suite in this directory, in a fixed order, each as
 * its own child process so a crashed suite cannot take the others down.
 * Suites that need a live SSH host or the assembled DSH tree skip themselves
 * (exit 0 with a SKIP note) when their environment variables are unset, so a
 * bare checkout always runs the pure suites.
 *
 * Usage:
 *   node tests/run.mjs                 # everything (live suites skip if not configured)
 *   node tests/run.mjs live acceptance # only the named suites
 *
 * Environment (all optional):
 *   DSH_CORE_ROOT     node_modules dir holding @deepseek-ai/* and ssh2
 *                     (e.g. an assembled copy of the installed app's tree)
 *   DSH_WS_TEST_ALIAS an alias from the host store / ~/.ssh/config to test against
 *   DSH_WS_TEST_DIR   remote scratch parent dir (default /tmp/dsh-ssh-workspace-test)
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

/** Suite order: pure checks first, live-host suites last. */
const SUITES = [
  'protocol',
  'client-shape',
  'lifecycle',
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

let failed = 0
for (const name of names) {
  const file = path.join(here, `${name}-smoke.mjs`)
  console.log(`\n──────────────────────────  ${name}-smoke  ──────────────────────────`)
  if (!existsSync(file)) {
    console.log(`  FAIL  suite file is missing: ${file}`)
    failed += 1
    continue
  }
  const result = spawnSync(process.execPath, [file], { stdio: 'inherit' })
  if (result.error !== undefined && result.error !== null) {
    console.log(`  FAIL  could not spawn the suite: ${result.error.message}`)
    failed += 1
  } else if (result.status !== 0) {
    failed += 1
  }
}

console.log(`\n=== run.mjs: ${names.length - failed}/${names.length} suite(s) reported success ===`)
process.exit(failed === 0 ? 0 : 1)
