/**
 * Capability-probe checks.
 *
 * The probe turns "the user discovers a missing tool by hitting its failure"
 * into an up-front answer, so its two hard properties are:
 *
 * - a tool the host has is reported present, and a missing one is reported
 *   absent — without one missing tool poisoning the others (the sweep prints a
 *   marker per tool and never fails the command);
 * - an answer that cannot be trusted stays `undefined` instead of becoming a
 *   false negative, and a determined answer is cached while an undetermined one
 *   is not.
 *
 * These drive `probeCapabilities` against an `exec` double, so no host is
 * needed and the exact script/parsing contract is visible.
 *
 * Run: node tests/capabilities-smoke.mjs
 */

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { SshWorkspaceEngine } = await import(pathToFileURL(path.join(pluginRoot, 'lib/engine.js')).href)

let passed = 0
let failures = 0
function check (label, ok, detail) {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`) } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

/**
 * An engine whose remote shell answers with a canned outcome.
 *
 * `exec` is the single seam the probe uses, so replacing it makes the probe run
 * for real against a chosen answer.
 */
function engineWith (responder) {
  const engine = new SshWorkspaceEngine({})
  const calls = []
  engine.exec = async (alias, command, options) => {
    calls.push({ alias, command, options })
    return responder({ alias, command, options })
  }
  return { engine, calls }
}

/**
 * A successful sweep that found the named tools.
 *
 * The answer uses the PREFIXED line format (`dsh-tool:rg`), not bare names:
 * presence is decided by a whole-line match, because a substring test over the
 * captured output reported a tool present when its name merely appeared inside
 * a path or a locale value. The environment facts now share that same stream,
 * which is what turned the old substring test from a theoretical flaw into a
 * routine false positive.
 */
function found (...names) {
  const lines = names.map(name => `dsh-tool:${name}\n`).join('')
  return { success: true, exitCode: 0, timedOut: false, stdout: `${lines}dsh-probe-done\n`, stderr: '', truncated: false, durationMs: 1 }
}

console.log('\n=== capabilities smoke ===\n')

// --- all three present ----------------------------------------------------
{
  const { engine, calls } = engineWith(() => found('rg', 'git', 'inotifywait'))
  const result = await engine.probeCapabilities('alpha')
  check('a fully equipped host reports rg present', result.rg === true, String(result.rg))
  check('a fully equipped host reports git present', result.git === true, String(result.git))
  check('a fully equipped host reports inotifywait present', result.inotifywait === true, String(result.inotifywait))
  check('the sweep is one round trip', calls.length === 1, String(calls.length))
  check('the sweep asks for all three tools in one command',
    ['rg', 'git', 'inotifywait'].every(name => calls[0].command.includes(`command -v ${name}`)), calls[0].command)
  engine.dispose()
}

// --- none present ---------------------------------------------------------
{
  const { engine } = engineWith(() => found())
  const result = await engine.probeCapabilities('bare')
  check('a bare host reports rg absent', result.rg === false, String(result.rg))
  check('a bare host reports git absent', result.git === false, String(result.git))
  check('a bare host reports inotifywait absent', result.inotifywait === false, String(result.inotifywait))
  engine.dispose()
}

// --- one missing does not poison the others ------------------------------
{
  const { engine } = engineWith(() => found('git'))
  const result = await engine.probeCapabilities('partial')
  check('a missing rg does not hide git', result.rg === false && result.git === true, JSON.stringify(result))
  check('a missing rg does not hide inotifywait being absent', result.inotifywait === false, String(result.inotifywait))
  engine.dispose()
}

// --- a broken answer stays unknown ---------------------------------------
{
  // No completion marker: the sweep may have died halfway, so nothing is known.
  const { engine } = engineWith(() => ({ success: true, exitCode: 0, timedOut: false, stdout: 'rg\n', stderr: '', truncated: false, durationMs: 1 }))
  const result = await engine.probeCapabilities('noisy')
  check('an answer without the completion marker stays unknown', result.rg === undefined && result.git === undefined && result.inotifywait === undefined, JSON.stringify(result))
  engine.dispose()
}

{
  // A failed sweep is unknown, not "everything missing".
  const { engine } = engineWith(() => ({ success: false, exitCode: 127, timedOut: false, stdout: '', stderr: 'not found', truncated: false, durationMs: 1 }))
  const result = await engine.probeCapabilities('broken')
  check('a failed sweep does not report the tools missing', result.rg === undefined && result.git === undefined && result.inotifywait === undefined, JSON.stringify(result))
  engine.dispose()
}

{
  // A throwing transport is unknown too; the probe never throws.
  const { engine } = engineWith(() => { throw new Error('connection lost') })
  let threw
  let result
  try { result = await engine.probeCapabilities('dead') } catch (error) { threw = error }
  check('a dead transport does not throw', threw === undefined, String(threw))
  check('a dead transport reports unknown', result?.rg === undefined && result?.git === undefined, JSON.stringify(result))
  engine.dispose()
}

// --- caching ------------------------------------------------------------
{
  const { engine, calls } = engineWith(() => found('rg'))
  await engine.probeCapabilities('cached')
  await engine.probeCapabilities('cached')
  check('a determined answer is cached', calls.length === 1, String(calls.length))
  await engine.probeCapabilities('cached', { refresh: true })
  check('refresh bypasses the cache', calls.length === 2, String(calls.length))
  engine.dispose()
}

{
  // An undetermined answer must NOT be cached: one bad probe would otherwise
  // make the host look unequipped for the rest of the session.
  let attempt = 0
  const { engine, calls } = engineWith(() => {
    attempt += 1
    return attempt === 1
      ? { success: true, exitCode: 0, timedOut: false, stdout: 'no marker', stderr: '', truncated: false, durationMs: 1 }
      : found('rg', 'git', 'inotifywait')
  })
  const first = await engine.probeCapabilities('flaky')
  check('the first (broken) probe stays unknown', first.rg === undefined, JSON.stringify(first))
  const second = await engine.probeCapabilities('flaky')
  check('a later probe is retried instead of trusting the unknown', calls.length === 2, String(calls.length))
  check('the retry reports the real answer', second.rg === true && second.git === true, JSON.stringify(second))
  engine.dispose()
}

console.log(`\n=== ${passed} passed, ${failures} failed ===`)
process.exit(failures === 0 ? 0 : 1)
