/**
 * The verdict behind the status dot.
 *
 * The report is a FACT SHEET — nine sections of what happened and not one line
 * saying whether that is good or bad (`support-bundle.js` assembles and never
 * judges). `diagnosis.js` is the judgement half, and its whole claim is that it
 * can be WRONG in only two directions, both of which must be caught here:
 *
 *  - too LOUD: a normal startup reported as a problem (a `broken` patch is
 *    load-bearing, a `pending` one has not registered yet, a connection the
 *    background loop is already retrying is transient). A dot that goes red
 *    on every healthy start is a dot nobody reads.
 *  - too QUIET: a real problem folded into `ok` — which is the failure mode the
 *    whole module exists to prevent, because it is indistinguishable from
 *    "nothing to report".
 *
 * The third claim is separability: `unknown` is neither. An unreachable host
 * is not a host missing every tool it owns, and "I could not look" must not
 * render as either green or red.
 *
 * Run: node tests/diagnosis-smoke.mjs
 */

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { diagnose, renderDiagnosis, STATE, DIAGNOSIS_VERSION } = await import(
  pathToFileURL(path.join(pluginRoot, 'lib/diagnosis.js')).href
)
const { buildSupportBundle, maskAlias } = await import(
  pathToFileURL(path.join(pluginRoot, 'lib/support-bundle.js')).href
)

let passed = 0
let failures = 0
function check (label, ok, detail) {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`) } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

console.log('\n=== diagnosis smoke ===\n')

// ---------------------------------------------------------------------------
console.log('[a healthy startup is green]')

{
  // Everything a real, working deployment reports on every start. Every one of
  // these is NORMAL, and any of them turning the dot red would make the dot
  // worthless.
  const report = diagnose({
    pluginVersion: '0.2.7',
    upstreamWorkarounds: [
      { id: 'UPSTREAM-1', probe: 'broken', detail: 'still load-bearing' },
      { id: 'PATCH-fs', probe: 'already', detail: 'relaxed in another context' },
      { id: 'PATCH-x', probe: 'pending', detail: 'not registered yet' },
      { id: 'PATCH-y', probe: 'disabled', detail: 'the operator skipped it' },
    ],
    connections: [{ alias: 'box', state: 'connected', inFlight: 0, generation: 1 }],
    capabilities: [{ alias: 'box', tools: { rg: true, git: true, inotifywait: true, sha256sum: true, tar: true, rsync: true, tput: true }, environment: { shell: '/bin/bash', locale: 'en_US.UTF-8', diskFreeKb: 900000, inotifyWatches: 20000 } }],
  })
  check('a normal startup is ok', report.state === STATE.ok, JSON.stringify(report.findings))
  check('...with no findings at all', report.findings.length === 0, JSON.stringify(report.findings))
  check('...and a zero count', report.warn === 0 && report.unknown === 0, `${report.warn}/${report.unknown}`)
  check('the text says so plainly', renderDiagnosis(report).startsWith('verdict: ok'), renderDiagnosis(report))
}

{
  // A connection that dropped and is being retried is TRANSIENT: the panel
  // says "reconnecting in 8s". The dot must not contradict the panel.
  const report = diagnose({
    pluginVersion: '1',
    connections: [{ alias: 'box', state: 'broken', inFlight: 0, generation: 2 }],
    reconnecting: [{ alias: 'box', phase: 'waiting', attempts: 3, lastError: 'ECONNREFUSED' }],
  })
  check('a connection being retried is not a standing problem', report.state === STATE.ok, JSON.stringify(report.findings))
}

// ---------------------------------------------------------------------------
console.log('\n[a real problem is red, and says which one]')

{
  const report = diagnose({ pluginVersion: '1', upstreamWorkarounds: [{ id: 'UPSTREAM-9', probe: 'fixed', detail: 'the Host no longer needs it' }] })
  check('an obsolete patch is a finding', report.state === STATE.warn, JSON.stringify(report))
  check('...naming the patch', report.findings[0].id === 'upstream:UPSTREAM-9', report.findings[0].id)
  check('...and telling the user to delete it', /delete/u.test(report.findings[0].detail), report.findings[0].detail)
}

{
  const report = diagnose({ pluginVersion: '1', unpinnedHostKeys: [{ alias: 'qiyk-server', keyType: 'ssh-ed25519', fingerprint: 'SHA256:abc' }] })
  check('an unpinned host key is a finding', report.state === STATE.warn, JSON.stringify(report))
  check('...carrying the fingerprint a reader needs', report.findings[0].detail.includes('SHA256:abc'), report.findings[0].detail)
  // The alias travels as its own FIELD, never inside the sentence: the report
  // masks the field, so a sentence that already embedded it could not be
  // masked without a second rule.
  check('...and keeping the alias out of the sentence', !report.findings[0].detail.includes('qiyk-server'), report.findings[0].detail)
  check('...while the alias is available as a field', report.findings[0].alias === 'qiyk-server', report.findings[0].alias)
}

{
  const report = diagnose({ pluginVersion: '1', hostsSkipped: [{ alias: 'bastion', reason: 'configured with a jump host' }] })
  check('a host that cannot be used is a finding', report.state === STATE.warn, JSON.stringify(report))
  check('...quoting the reason', report.findings[0].detail.includes('jump host'), report.findings[0].detail)
  const store = diagnose({ pluginVersion: '1', storeError: 'permission denied' })
  check('an unreadable host store is a finding', store.state === STATE.warn && store.findings[0].id === 'host-store', JSON.stringify(store))
}

{
  const report = diagnose({
    pluginVersion: '1',
    connections: [{ alias: 'box', state: 'broken', inFlight: 0, generation: 3 }],
  })
  check('a broken connection nothing is retrying is a finding', report.state === STATE.warn, JSON.stringify(report))
  const gaveUp = diagnose({ pluginVersion: '1', reconnecting: [{ alias: 'box', phase: 'gave-up', attempts: 40, lastError: 'auth failed' }] })
  check('a stopped retry loop is a finding', gaveUp.state === STATE.warn, JSON.stringify(gaveUp))
  check('...quoting the last error', gaveUp.findings[0].detail.includes('auth failed'), gaveUp.findings[0].detail)
}

{
  const report = diagnose({ pluginVersion: '1', forwardRows: [{ alias: 'box', localHost: '127.0.0.1', localPort: 5173, remotePort: 5173, error: 'local port 5173 is already in use' }] })
  check('a saved forward that failed to open is a finding', report.state === STATE.warn, JSON.stringify(report))
  const healthy = diagnose({ pluginVersion: '1', forwardRows: [{ alias: 'box', localHost: '127.0.0.1', localPort: 5173, remotePort: 5173, enabled: true }] })
  check('...and a forward without an error is not', healthy.state === STATE.ok, JSON.stringify(healthy.findings))
}

{
  // A missing tool degrades a feature the user can fix; that is a finding.
  const report = diagnose({
    pluginVersion: '1',
    capabilities: [{ alias: 'box', tools: { rg: false, git: true }, environment: { shell: '/bin/bash', locale: 'en_US.UTF-8', diskFreeKb: 900000, inotifyWatches: 20000 } }],
  })
  check('a missing tool is a finding', report.state === STATE.warn, JSON.stringify(report))
  check('...naming the tool and its consequence', /rg/u.test(report.findings[0].detail) && /glob/u.test(report.findings[0].detail), report.findings[0].detail)
  // A non-POSIX shell / a non-UTF-8 locale are warnings with a consequence, and
  // they come from the SAME self-check the panel renders.
  const env = diagnose({
    pluginVersion: '1',
    capabilities: [{ alias: 'box', tools: {}, environment: { shell: '/bin/fish', locale: 'de_DE.ISO-8859-1', diskFreeKb: 20 * 1024, inotifyWatches: 512 } }],
  })
  check('an environment warning is a finding', env.state === STATE.warn, JSON.stringify(env.findings.map(f => f.id)))
  check('...one row per warning, not one merged row',
    env.findings.filter(f => f.id.startsWith('env:')).length >= 3,
    JSON.stringify(env.findings.map(f => f.id)))
}

{
  const report = diagnose({
    pluginVersion: '1',
    commands: [
      { alias: 'box', command: 'ls', exitCode: 0, timedOut: false },
      // A non-zero exit is the correct answer to some questions (`grep`
      // finding nothing exits 1), so it is NOT a finding.
      { alias: 'box', command: 'grep -q x file', exitCode: 1, timedOut: false },
      { alias: 'box', command: 'sleep 100', exitCode: null, timedOut: true },
      { alias: 'box', command: 'rm -rf /srv/x', outcomeUnknown: true },
      // A refusal is a policy decision, not a malfunction: the plugin did what
      // it was told.
      { alias: 'box', command: 'rm -rf /', refused: true },
    ],
  })
  // Counting the command findings, not grepping their prose: an implementation
  // that flagged every non-zero exit would print the SAME sentence, so a
  // `detail.includes('grep')` check cannot see the regression. Five commands
  // are supplied; exactly two of them are findings (timed out, outcome
  // unknown).
  const commandFindings = report.findings.filter(f => f.id === 'command').length
  check('exactly the two undeterminate commands are findings', commandFindings === 2, String(commandFindings))
  check('a non-zero exit is not a finding', !report.findings.some(f => f.detail.includes('grep')), JSON.stringify(report.findings.map(f => f.detail)))
  check('a refusal is not a finding', !report.findings.some(f => /refused|not run/u.test(f.detail)), JSON.stringify(report.findings.map(f => f.detail)))
  check('a timed-out command is a finding', report.findings.some(f => /timed out/u.test(f.detail)), JSON.stringify(report.findings.map(f => f.detail)))
  check('a command cut off mid-flight is a finding', report.findings.some(f => /may or may not have run/u.test(f.detail)), JSON.stringify(report.findings.map(f => f.detail)))
}

// ---------------------------------------------------------------------------
console.log('\n[unknown is neither green nor red]')

{
  const report = diagnose({ pluginVersion: '1', capabilities: [{ alias: 'box', tools: {}, environment: {} }] })
  check('a host that could not be probed is unknown, not ok', report.state === STATE.unknown, JSON.stringify(report))
  check('...and not red either', report.state !== STATE.warn, report.state)
  check('...and every tool is reported as undetermined', report.findings.every(f => f.state === STATE.unknown), JSON.stringify(report.findings.map(f => f.state)))
  check('...never as missing', !report.findings.some(f => /is missing/u.test(f.detail)), JSON.stringify(report.findings.map(f => f.detail)))
}

{
  // The aggregate rule: an actionable fact beats a could-not-judge. A red dot
  // that says "and also I could not judge something" is still a red dot.
  const report = diagnose({
    pluginVersion: '1',
    capabilities: [{ alias: 'box', tools: { rg: false }, environment: {} }],
    upstreamWorkarounds: [{ id: 'U', probe: 'unprobeable', detail: '' }],
  })
  check('a definite problem wins over an undetermined one', report.state === STATE.warn, JSON.stringify(report))
  check('...while both counts stay visible', report.warn > 0 && report.unknown > 0, `${report.warn}/${report.unknown}`)
}

{
  const report = diagnose({ pluginVersion: '' })
  check('an unreadable plugin version is unknown', report.state === STATE.unknown, JSON.stringify(report))
}

// ---------------------------------------------------------------------------
console.log('\n[the report carries the verdict, and it agrees with the sections]')

{
  const input = {
    pluginVersion: '0.2.7',
    unpinnedHostKeys: [{ alias: 'qiyk-server', keyType: 'ssh-ed25519', fingerprint: 'SHA256:abc' }],
    upstreamWorkarounds: [{ id: 'UPSTREAM-9', probe: 'fixed', detail: 'the Host no longer needs it' }],
  }
  const bundle = buildSupportBundle(input)
  check('the bundle opens with a diagnosis section', /^## diagnosis$/mu.test(bundle), bundle.slice(0, 200))
  check('...before the versions', bundle.indexOf('\n## diagnosis\n') < bundle.indexOf('\n## versions\n'), bundle.slice(0, 400))
  check('...declaring its own shape version', bundle.includes(`diagnosisVersion: ${DIAGNOSIS_VERSION}`), String(DIAGNOSIS_VERSION))
  check('...stating the verdict', /verdict: needs attention/u.test(bundle), bundle.split('\n').find(line => line.startsWith('verdict')) ?? '')
  check('...naming both findings', bundle.includes('UPSTREAM-9') && bundle.includes('NOT PINNED'), bundle)
  // The alias must be MASKED in the verdict line, exactly as in every other
  // section: one masking rule for one string, or the report stops correlating.
  check('the alias in a finding is masked', !bundle.includes('qiyk-server'), bundle.split('\n').filter(line => line.includes('PINNED')).join(' | '))
  check('...with the masked form present', bundle.includes(maskAlias('qiyk-server')), maskAlias('qiyk-server'))
}

{
  // The verdict is DERIVED, never asserted: if the sections say nothing is
  // wrong, the verdict cannot claim otherwise. This is the property that keeps
  // the dot and the paste from telling two stories.
  const clean = buildSupportBundle({ pluginVersion: '0.2.7', hosts: [], mounted: [], connections: [], capabilities: [] })
  check('an empty input produces an ok verdict', /verdict: ok/u.test(clean), clean.split('\n').find(line => line.startsWith('verdict')) ?? '')
  const dirty = buildSupportBundle({ pluginVersion: '0.2.7', hostsSkipped: [{ alias: 'b', reason: 'jump host' }] })
  check('...and a skipped host alone turns it red', /verdict: needs attention/u.test(dirty), dirty.split('\n').find(line => line.startsWith('verdict')) ?? '')
}

// ---------------------------------------------------------------------------
console.log('\n[the report gained the facts it used to omit]')

{
  const bundle = buildSupportBundle({
    pluginVersion: '0.2.7',
    hostsSkipped: [{ alias: 'bastion', reason: 'configured with a jump host' }],
    storeError: 'permission denied',
    unpinnedHostKeys: [{ alias: 'qiyk-server', keyType: 'ssh-ed25519', fingerprint: 'SHA256:abc' }],
    connections: [{ alias: 'box', state: 'connected', inFlight: 0, generation: 3 }],
    forwardRows: [{ alias: 'box', localHost: '127.0.0.1', localPort: 5173, remotePort: 5173, error: 'port in use' }],
  })
  check('a skipped host appears instead of vanishing', /skipped:/u.test(bundle), bundle)
  check('...with its reason', bundle.includes('jump host'), bundle)
  check('...and its alias masked', !bundle.includes('bastion'), bundle)
  check('an unreadable store is stated', bundle.includes('store error:'), bundle)
  check('host keys have their own section', /^## host keys$/mu.test(bundle), bundle.slice(0, 600))
  check('...saying NOT PINNED', bundle.includes('NOT PINNED'), bundle)
  check('a generation above 1 explains itself', /generation 3/u.test(bundle), bundle.split('\n').filter(line => line.includes('connected')).join(' | '))
  check('a failed saved forward is listed', /is NOT open/u.test(bundle), bundle)
  // The old one-liner merged "no patches" with "I could not look"; the new
  // wording must not claim nothing was installed.
  check('an empty patch list does not claim "none installed"', !/none installed/u.test(bundle), bundle)
}

// ---------------------------------------------------------------------------
console.log('\n[the verdict survives bad input]')

{
  for (const input of [undefined, null, {}, { capabilities: [null] }, { connections: [{}] }, { commands: [{}] }, { upstreamWorkarounds: [{}] }]) {
    let threw = false
    try { diagnose(input) } catch { threw = true }
    check(`diagnose(${JSON.stringify(input)}) does not throw`, !threw)
  }
  const junk = diagnose({ capabilities: [{}], commands: [{}], connections: [{}] })
  check('a malformed probe reads as unknown, not absent', junk.state === STATE.unknown, JSON.stringify(junk))
  check('...and a malformed command is not invented as a failure', !junk.findings.some(f => f.id === 'command'), JSON.stringify(junk.findings.map(f => f.id)))
}

console.log(`\n=== ${passed} passed, ${failures} failed ===`)
process.exit(failures === 0 ? 0 : 1)
