/**
 * The relaxation, against the REAL `dsh-working-directory` schema and REAL zod.
 *
 * `projection-relax-smoke` proves the logic with a schema double. That is not
 * enough here: the whole defect lives in a zod detail — `.refine(isAbsolute)`
 * captures the predicate as a VALUE, so republishing the ESM binding cannot
 * reach it — and a double could accidentally be relaxed by a mechanism that
 * does not exist for real zod. This suite therefore mounts the Host's own
 * `SessionProjectionRegistry` and `WorkingDirectoryService` from an assembled
 * DSH tree, in the production order (service first, plugin patch second), and
 * drives the exact read path a history load takes.
 *
 * SKIPs without DSH_CORE_ROOT pointing at a real tree: a stub root cannot stand
 * in for zod, and a false pass would be worse than an honest skip.
 *
 * Run: DSH_CORE_ROOT=/path/to/node_modules node tests/projection-real-smoke.mjs
 */

import { syncBuiltinESMExports } from 'node:module'
import nodePath from 'node:path'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { skipWithoutRealPeers } from './support/peer-mode.mjs'

const coreRoot = process.env.DSH_CORE_ROOT
if (!coreRoot) {
  console.log('\n=== projection real smoke ===\n')
  console.log('  SKIP  DSH_CORE_ROOT is not set (needs the assembled DSH tree with zod)')
  console.log('\n=== 0 passed, 0 failed, 1 suite skipped ===')
  process.exit(0)
}
// Only these four matter here, and three of them are ESM-only host packages that
// cannot be `require()`d: for those, resolution is all this detector can honestly
// prove, so it stops there instead of calling a resolvable package broken.
skipWithoutRealPeers('projection real smoke', 'the assembled DSH tree (dsh-session-projection, dsh-working-directory, zod)', {
  requires: [
    '@deepseek-ai/cordis',
    { name: '@deepseek-ai/dsh-session-projection', introspect: false },
    { name: '@deepseek-ai/dsh-working-directory', introspect: false },
    { name: 'zod', introspect: false },
  ],
})

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const requireFromCore = createRequire(path.join(coreRoot, 'noop.cjs'))

let passed = 0
let failures = 0
/**
 * @param {string} label - what is being asserted.
 * @param {boolean} ok - the assertion.
 * @param {string} [detail] - shown after the label on a PASS and a FAIL.
 * @param {string} [onFail] - extra guidance shown ONLY on failure. Used to make
 *   the inverted assertion below announce its own remedy: the person who sees
 *   it red is by definition not the person who read the banner comment.
 */
function check (label, ok, detail, onFail) {
  if (ok) {
    passed += 1
    console.log(`  PASS  ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
    if (onFail !== undefined) console.log(`        ${onFail}`)
  }
}

console.log('\n=== projection real smoke ===\n')
console.log(`[core: ${coreRoot}]`)

const { Context } = requireFromCore('@deepseek-ai/cordis')
const { SessionProjectionRegistry } = await import(pathToFileURL(requireFromCore.resolve('@deepseek-ai/dsh-session-projection')).href)
const { WorkingDirectoryService } = await import(pathToFileURL(requireFromCore.resolve('@deepseek-ai/dsh-working-directory')).href)
const { installProjectionRelaxation, uninstallProjectionRelaxation } = await import(pathToFileURL(path.join(pluginRoot, 'lib/patch/patch-projection.js')).href)

const SSH_CWD = 'ssh://qiyk/home/qiyk/test'
const LOCAL_CWD = path.resolve(pluginRoot)

/**
 * Printed under a red line in section 1. The whole point of this suite's first
 * assertions is inverted — they assert a DEFECT — so a failure here has to carry
 * its own interpretation. A reader who finds a red line in CI has not read the
 * banner above, and "fix the test" is the wrong reflex by construction.
 */
const DELETE_THE_WORKAROUND = [
  '^^^ THIS IS NOT A REGRESSION. Delete the upstream workaround instead:',
  '      1. lib/index.js — the `ctx.inject([\'sessionProjections\'], …)` block with the',
  '         `UPSTREAM WORKAROUND #1` banner, and the patch-projection.js import above it;',
  '      2. lib/patch/patch-projection.js;',
  '      3. tests/projection-relax-smoke.mjs and this file (tests/projection-real-smoke.mjs);',
  '         remove `projection-relax` / `projection-real` from tests/run.mjs SUITES;',
  '      4. docs/upstream-workarounds.md, and its rows in docs/README.md, README.md, README.en.md;',
  '      5. the `archive` entry in CHANGELOG.md.',
  '    Runbook: docs/upstream-workarounds.md',
].join('\n        ')

/** Mount the two host services in the order the roster uses. */
function mountHost () {
  const ctx = new Context()
  new SessionProjectionRegistry(ctx)
  // The one service `working-directory` touches at construction.
  ctx.systemPrompt = { context () {}, getContextOrder: () => 0 }
  const service = new WorkingDirectoryService(ctx, { defaultDirectory: path.parse(pluginRoot).root })
  return { ctx, service }
}

/** The exact read a cold history load performs. */
function probe (ctx, cwd) {
  try {
    const restored = ctx.sessionProjections.restore({}, [], 0, { cwd }, 0)
    return { ok: true, value: restored.snapshot.values.workingDirectory }
  } catch (error) {
    return { ok: false, message: error.message.replace(/\s+/g, ' ').trim() }
  }
}

// ---------------------------------------------------------------------------
// 1. The bug, on the real schema: an ssh:// cwd fails the view schema.
//    This is what the browser reports as 历史加载失败 … Invalid input.
//
//    ⚠ READ THIS BEFORE "FIXING" A RED LINE HERE. This section asserts the Host
//    defect STILL EXISTS. It goes red on the DSH release that changes
//    `refine(isAbsolute)` to `refine((value) => isAbsolute(value))` — and a red
//    there means the upstream workaround has done its job and must be DELETED
//    (lib/patch/patch-projection.js, its index.js block, this suite, and
//    docs/upstream-workarounds.md). It is not a regression.
//
//    The failure text says all of that too (DELETE_THE_WORKAROUND below): the
//    banner only helps whoever opens this file, and the person looking at a red
//    CI line is usually not that person.
// ---------------------------------------------------------------------------
const { ctx } = mountHost()
{
  const result = probe(ctx, SSH_CWD)
  check('the real workingDirectory viewSchema rejects an ssh:// cwd (the reported bug)',
    result.ok === false && /Invalid input/.test(result.message), result.ok ? `unexpectedly passed: ${result.value}` : result.message,
    DELETE_THE_WORKAROUND)
  check('...while the same schema accepts a local absolute path', probe(ctx, LOCAL_CWD).ok === true)
  check('=> the UPSTREAM-1 workaround is therefore still load-bearing on this Host build',
    result.ok === false, undefined, DELETE_THE_WORKAROUND)
}

// ---------------------------------------------------------------------------
// 2. Patching `node:path` the way fs-shim.js does is NOT enough.
//    This is the half of the diagnosis that has to stay true, or the relaxation
//    would be unnecessary.
// ---------------------------------------------------------------------------
{
  const original = nodePath.isAbsolute
  nodePath.isAbsolute = function isAbsolute (candidate) {
    if (typeof candidate === 'string' && /^ssh:\/\//i.test(candidate)) return true
    return original(candidate)
  }
  try {
    syncBuiltinESMExports()
    check('the patched binding does answer true for ssh://', nodePath.isAbsolute(SSH_CWD) === true)
    check('...yet the already-built schema still rejects it (the capture, not the binding)',
      probe(ctx, SSH_CWD).ok === false)
  } finally {
    nodePath.isAbsolute = original
    syncBuiltinESMExports()
  }
}

// ---------------------------------------------------------------------------
// 3. The plugin's relaxation fixes every read path that parses the value.
// ---------------------------------------------------------------------------
{
  const installed = installProjectionRelaxation(ctx, {})
  check('the relaxation found the already-registered unit in place', installed?.relaxedInPlace === true)
  check('...and did not conclude the Host was already fixed (it is not, on this build)',
    installed?.upstreamFixed === false)
  check('...and reported the judgement as `broken`, which is what makes it actionable',
    installed?.probe === 'broken', installed?.probe)

  const restored = probe(ctx, SSH_CWD)
  check('restore() now yields the ssh:// cwd', restored.ok === true && restored.value === SSH_CWD,
    restored.ok ? restored.value : restored.message)

  const checkpoint = { workingDirectory: { ver: 1, seq: 2, val: SSH_CWD } }
  const listed = ctx.sessionProjections.viewCheckpoint(checkpoint)
  check('viewCheckpoint (the zero-I/O listing rung) yields it too',
    listed?.workingDirectory === SSH_CWD, JSON.stringify(listed?.workingDirectory))

  const withRow = ctx.sessionProjections.restore(checkpoint, [], 0, { cwd: SSH_CWD }, 0)
  check('restore() with a usable checkpoint row yields it',
    withRow?.snapshot?.values?.workingDirectory === SSH_CWD,
    JSON.stringify(withRow?.snapshot?.values?.workingDirectory))
}

// ---------------------------------------------------------------------------
// 4. Nothing else was loosened: the real zod rules still hold.
// ---------------------------------------------------------------------------
{
  check('a relative local cwd is still rejected', probe(ctx, 'relative/dir').ok === false)
  check('an empty cwd is still rejected', probe(ctx, '').ok === false)
  check('a null cwd still passes (a session with no recorded directory)',
    probe(ctx, null).ok === true)
  check('a local absolute cwd still passes unchanged',
    probe(ctx, LOCAL_CWD).ok === true && probe(ctx, LOCAL_CWD).value === LOCAL_CWD)
}

// ---------------------------------------------------------------------------
// 5. A unit that registers AFTER the plugin installed is relaxed on arrival —
//    the reload / harness order.
// ---------------------------------------------------------------------------
{
  const fresh = new Context()
  new SessionProjectionRegistry(fresh)
  fresh.systemPrompt = { context () {}, getContextOrder: () => 0 }

  const installed = installProjectionRelaxation(fresh, {})
  check('installing before the unit exists reports no in-place find', installed?.relaxedInPlace === false)

  new WorkingDirectoryService(fresh, { defaultDirectory: path.parse(pluginRoot).root })
  const result = probe(fresh, SSH_CWD)
  check('the unit registered afterwards is relaxed on arrival',
    result.ok === true && result.value === SSH_CWD, result.ok ? result.value : result.message)
}

// ---------------------------------------------------------------------------
// 6. Disposal keeps an already-open session loading.
// ---------------------------------------------------------------------------
{
  uninstallProjectionRelaxation(ctx)
  const result = probe(ctx, SSH_CWD)
  check('after uninstall an open ssh:// session still loads',
    result.ok === true && result.value === SSH_CWD, result.ok ? result.value : result.message)
}

console.log(`\n=== ${passed} passed, ${failures} failed ===`)
process.exit(failures === 0 ? 0 : 1)
