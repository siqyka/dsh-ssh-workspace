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
  'client-shape',  'backdrop-dismiss',
  'projection-relax',
  'projection-real',
  'tree-transfer',
  'insert-once',
  'locale-register',
  'detach',
  'probe',
  'lifecycle',
  'phase6',
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

let failed = 0
for (const name of names) {
  const file = path.join(here, `${name}-smoke.mjs`)
  console.log(`\n──────────────────────────  ${name}-smoke  ──────────────────────────`)
  if (!existsSync(file)) {
    console.log(`  FAIL  suite file is missing: ${file}`)
    failed += 1
    continue
  }
  const result = spawnSync(process.execPath, [file], { stdio: 'inherit', env: childEnv })
  if (result.error !== undefined && result.error !== null) {
    console.log(`  FAIL  could not spawn the suite: ${result.error.message}`)
    failed += 1
  } else if (result.status !== 0) {
    failed += 1
  }
}

console.log(`\n=== run.mjs: ${names.length - failed}/${names.length} suite(s) reported success ===`)
process.exit(failed === 0 ? 0 : 1)
