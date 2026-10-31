/**
 * The remote self-check: three-valued, and honest about what it does not know.
 *
 * The self-check exists because a missing remote tool used to surface as a
 * feature that "just did not work" — no `rg` meant glob failed with exit 127,
 * no `git` silently turned change tracking off, no `inotifywait` turned
 * watching into polling. Each of those is a sentence the user never got.
 *
 * The properties that matter, and that a careless implementation loses:
 *
 *  1. **Three states, never two.** A host the probe could not reach must read
 *     as UNKNOWN, not as "missing everything". Collapsing them turns one
 *     unreachable probe into a page of red marks about a healthy host.
 *  2. **Absence carries a fix; uncertainty does not.** An install hint on an
 *     unknown row invites the user to install a tool they may already have.
 *  3. **The vocabulary is one table.** Adding a capability must be a row in
 *     `TOOL_CAPABILITIES`, not a new branch in four renderers — so the probe's
 *     tool list is derived from it, and this suite asserts that.
 *  4. **Environment findings are warnings, not verdicts.** A non-UTF-8 locale
 *     and a low inotify limit are both real hazards, and neither is a reason
 *     to refuse anything.
 *
 * Run: node tests/capabilities-report-smoke.mjs
 */

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const {
  TOOL_CAPABILITIES,
  probedTools,
  selfCheckRows,
  environmentFindings,
  selfCheck,
  renderSelfCheck,
} = await import(pathToFileURL(path.join(pluginRoot, 'lib/capabilities.js')).href)

let passed = 0
let failures = 0
function check (label, ok, detail) {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`) } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

console.log('\n=== capabilities report smoke ===\n')

// ---------------------------------------------------------------------------
console.log('[the vocabulary is one table]')

check('the table is non-empty', TOOL_CAPABILITIES.length > 0, String(TOOL_CAPABILITIES.length))
check(
  'every row names a tool, a feature, a consequence and an install hint',
  TOOL_CAPABILITIES.every(spec => typeof spec.tool === 'string' && spec.tool !== '' &&
    typeof spec.feature === 'string' && spec.feature !== '' &&
    typeof spec.whenMissing === 'string' && spec.whenMissing !== '' &&
    typeof spec.install === 'string' && spec.install !== ''),
  JSON.stringify(TOOL_CAPABILITIES.map(spec => spec.tool)),
)
check('tool names are unique', new Set(probedTools()).size === TOOL_CAPABILITIES.length, probedTools().join(','))
check(
  'the probe list is DERIVED from the table, not written twice',
  probedTools().every(tool => TOOL_CAPABILITIES.some(spec => spec.tool === tool)) &&
    probedTools().length === TOOL_CAPABILITIES.length,
  probedTools().join(','),
)
// The three original capabilities must keep their place at the front: a reader
// written against the first shape must still find them.
check('rg, git and inotifywait are still probed', ['rg', 'git', 'inotifywait'].every(tool => probedTools().includes(tool)), probedTools().join(','))
check('the transfer/terminal tools joined the probe', ['sha256sum', 'tar', 'rsync', 'tput'].every(tool => probedTools().includes(tool)), probedTools().join(','))

// ---------------------------------------------------------------------------
console.log('\n[three-valued, not two]')

{
  const all = Object.fromEntries(probedTools().map(tool => [tool, true]))
  const rows = selfCheckRows(all)
  check('an equipped host has no absent rows', rows.every(row => row.state === 'present'), JSON.stringify(rows.map(r => r.state)))
  check('...and its rendered report says so', renderSelfCheck(selfCheck(all, {})).startsWith('all probed tools are present'), renderSelfCheck(selfCheck(all, {})))
}

{
  const none = Object.fromEntries(probedTools().map(tool => [tool, false]))
  const rows = selfCheckRows(none)
  check('a bare host reports every row absent', rows.every(row => row.state === 'absent'), JSON.stringify(rows.map(r => r.state)))
  check('every absent row carries an install hint', rows.every(row => typeof row.install === 'string' && row.install !== ''))
  check('the report lists each missing tool', rows.filter(row => row.state === 'absent').every(row => renderSelfCheck(selfCheck(none, {})).includes(row.tool)))
}

{
  // THE property: undetermined is its own state.
  const unknown = Object.fromEntries(probedTools().map(tool => [tool, undefined]))
  const rows = selfCheckRows(unknown)
  check('an unprobed host reports every row unknown', rows.every(row => row.state === 'unknown'), JSON.stringify(rows.map(r => r.state)))
  check('an unknown row does NOT carry an install hint', rows.every(row => row.install === undefined), JSON.stringify(rows.map(r => r.install)))
  check('an unknown row does not reuse the missing wording',
    rows.every(row => row.detail !== undefined && /could not determine/u.test(row.detail)),
    String(rows[0]?.detail))
  check('an unknown row is not counted as missing', selfCheck(unknown, {}).missing.length === 0, JSON.stringify(selfCheck(unknown, {}).missing))
}

{
  // A result from an older shape may simply lack a key. That is unknown, not
  // absent: the probe never wrote the key, so nothing is known about it.
  const rows = selfCheckRows({ rg: true })
  check('a missing key reads as unknown, not absent',
    rows.filter(row => row.tool !== 'rg').every(row => row.state === 'unknown'),
    JSON.stringify(rows.map(r => `${r.tool}:${r.state}`)))
  check('the one known key keeps its verdict', rows.find(row => row.tool === 'rg').state === 'present')
}

{
  // Mixed: the interesting case for a reader.
  const mixed = Object.fromEntries(probedTools().map(tool => [tool, true]))
  mixed.git = false
  mixed.inotifywait = undefined
  const report = selfCheck(mixed, {})
  check('missing is reported exactly', report.missing.length === 1 && report.missing[0] === 'git', JSON.stringify(report.missing))
  const text = renderSelfCheck(report)
  check('the report names the missing tool', text.includes('MISSING git'), text)
  check('the report names the unknown tool', text.includes('UNKNOWN inotifywait'), text)
  check('present tools are not listed', !/MISSING rg/u.test(text), text)
}

// ---------------------------------------------------------------------------
console.log('\n[environment findings]')

{
  const findings = environmentFindings({ shell: '/bin/bash', locale: 'en_US.UTF-8', diskFreeKb: 500000, inotifyWatches: 8192 })
  check('a healthy environment has no warnings', findings.every(finding => finding.state === 'ok'), JSON.stringify(findings))
}

{
  const findings = environmentFindings({ shell: '/bin/csh', locale: 'fr_FR.ISO-8859-1', diskFreeKb: 1024, inotifyWatches: 100 })
  const states = findings.map(finding => finding.state)
  check('a non-POSIX login shell is a warning', findings.find(f => f.id === 'shell').state === 'warn')
  check('a non-UTF-8 locale is a warning', findings.find(f => f.id === 'locale').state === 'warn')
  check('low free disk is a warning', findings.find(f => f.id === 'disk').state === 'warn')
  check('a low inotify limit is a warning', findings.find(f => f.id === 'inotify').state === 'warn')
  check('all four fired', states.filter(state => state === 'warn').length === 4, states.join(','))
  check('the disk warning names the failure mode',
    /ENOSPC/u.test(findings.find(f => f.id === 'disk').detail),
    findings.find(f => f.id === 'disk').detail)
}

{
  const findings = environmentFindings({})
  check('nothing probed reads as unknown, not as healthy',
    findings.every(finding => finding.state === 'unknown'),
    JSON.stringify(findings))
}
{
  // An empty `$SHELL` is common on minimal containers; it must not become a
  // warning that reads as "your shell is wrong".
  const findings = environmentFindings({ shell: '', locale: '', diskFreeKb: undefined, inotifyWatches: undefined })
  check('an empty shell value is unknown, not a warning', findings.find(f => f.id === 'shell').state === 'unknown')
}

// ---------------------------------------------------------------------------
console.log('\n[the rendered report is stable enough to paste]')

{
  const report = selfCheck({ rg: true, git: false, inotifywait: true, sha256sum: false, tar: true, rsync: false, tput: true }, { shell: '/bin/sh', locale: 'C', diskFreeKb: 10, inotifyWatches: 4096 })
  const text = renderSelfCheck(report)
  check('the text is not empty', text.length > 0)
  check('every missing tool appears', ['git', 'sha256sum', 'rsync'].every(tool => text.includes(tool)), text)
  check('every warning appears', ['locale', 'disk'].every(id => text.includes(id)), text)
  check('the text does not claim a present tool is missing', !/MISSING rg/u.test(text), text)
}

// ---------------------------------------------------------------------------
console.log('\n[the probe asks for every capability the table names]')
{
  // Pin the probe against the table: a capability added to the table but not
  // asked for would be reported as unknown forever, which reads as "the host
  // might not have it" when the truth is "we never asked".
  const { SshWorkspaceEngine } = await import(pathToFileURL(path.join(pluginRoot, 'lib/engine.js')).href)
  const engine = new SshWorkspaceEngine({})
  const seen = []
  engine.exec = async (_alias, command) => {
    seen.push(command)
    // Answer as a host that has every tool.
    const lines = probedTools().map(tool => `dsh-tool:${tool}`).join('\n')
    return { success: true, exitCode: 0, timedOut: false, stdout: `${lines}\ndsh-probe-done\n`, stderr: '', truncated: false, durationMs: 1 }
  }
  const result = await engine.probeCapabilities('every')
  check('one round trip serves the whole sweep', seen.length === 1, String(seen.length))
  check('the sweep asks for every table tool', probedTools().every(tool => seen[0].includes(`command -v ${tool}`)), seen[0])
  check('the sweep asks for the environment facts too', ['dsh-env:shell', 'dsh-env:locale', 'dsh-env:disk', 'dsh-env:watch'].every(token => seen[0].includes(token)), seen[0])
  check('a fully answered sweep reports every tool present', probedTools().every(tool => result[tool] === true), JSON.stringify(result))
  engine.dispose()
}

{
  // The substring bug: presence used to be decided with `includes(name)` over
  // the whole output, so a path containing the name reported the tool present.
  const { SshWorkspaceEngine } = await import(pathToFileURL(path.join(pluginRoot, 'lib/engine.js')).href)
  const engine = new SshWorkspaceEngine({})
  engine.exec = async () => ({
    success: true,
    exitCode: 0,
    timedOut: false,
    // No `dsh-tool:` lines at all, but the word "rg" appears in a value.
    stdout: 'dsh-env:shell:/usr/bin/rg-shell\ndsh-env:locale:rg\ndsh-probe-done\n',
    stderr: '',
    truncated: false,
    durationMs: 1,
  })
  const result = await engine.probeCapabilities('tricky')
  check('a name appearing inside a value does not count as present', result.rg === false, String(result.rg))
  check('the sweep still produced verdicts for every tool', probedTools().every(tool => result[tool] === false), JSON.stringify(result))
  engine.dispose()
}

{
  // Environment facts must survive the same round trip.
  const { SshWorkspaceEngine } = await import(pathToFileURL(path.join(pluginRoot, 'lib/engine.js')).href)
  const engine = new SshWorkspaceEngine({})
  engine.exec = async () => ({
    success: true,
    exitCode: 0,
    timedOut: false,
    stdout: 'dsh-tool:rg\ndsh-env:shell:/bin/bash\ndsh-env:locale:en_US.UTF-8\ndsh-env:disk:123456\ndsh-env:watch:8192\ndsh-probe-done\n',
    stderr: '',
    truncated: false,
    durationMs: 1,
  })
  await engine.probeCapabilities('env')
  const environment = engine.environmentOf('env')
  check('the shell was captured', environment.shell === '/bin/bash', String(environment.shell))
  check('the locale was captured', environment.locale === 'en_US.UTF-8', String(environment.locale))
  check('the disk figure is a number', environment.diskFreeKb === 123456, String(environment.diskFreeKb))
  check('the inotify limit is a number', environment.inotifyWatches === 8192, String(environment.inotifyWatches))
  engine.dispose()
}

{
  // A sweep that could not answer must cache NOTHING — neither verdicts nor
  // environment — so the next attempt is a real attempt.
  const { SshWorkspaceEngine } = await import(pathToFileURL(path.join(pluginRoot, 'lib/engine.js')).href)
  const engine = new SshWorkspaceEngine({})
  let call = 0
  engine.exec = async () => {
    call += 1
    return call === 1
      ? { success: false, exitCode: 127, timedOut: false, stdout: '', stderr: 'no', truncated: false, durationMs: 1 }
      : { success: true, exitCode: 0, timedOut: false, stdout: 'dsh-tool:rg\ndsh-probe-done\n', stderr: '', truncated: false, durationMs: 1 }
  }
  const first = await engine.probeCapabilities('flaky')
  check('a failed sweep reports unknown', first.rg === undefined, String(first.rg))
  check('a failed sweep caches no environment', engine.environmentOf('flaky') === undefined, JSON.stringify(engine.environmentOf('flaky')))
  const second = await engine.probeCapabilities('flaky')
  check('the next sweep is a real sweep', call === 2, String(call))
  check('...and its answer is used', second.rg === true, String(second.rg))
  engine.dispose()
}

console.log(`\n=== ${passed} passed, ${failures} failed ===`)
process.exit(failures === 0 ? 0 : 1)
